// server.js
// Practica F06 - Endpoint con scraping de Shopify y base de datos Neon

const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = 3000;

// conexion a neon - aqui pones tu connection string
const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_aeP1vj5QFrfn@ep-tiny-block-am1y4k1v-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false },
});

// datos de la tienda shopify
const SHOPIFY_URL = "https://chevalier-9695.myshopify.com";
const PASS = "geveey";

// verificar que la conexion funciona
pool.connect((err, client, release) => {
  if (err) {
    console.error("Error conectando a Neon:", err.message);
  } else {
    console.log("Conexion a Neon exitosa");
    release();
  }
});

// crear la tabla de productos si no existe
async function crearTabla() {
  try {
    await pool.query(\`
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(500),
        precio VARCHAR(100),
        imagen TEXT,
        url TEXT,
        fecha_scraping TIMESTAMP DEFAULT NOW()
      )
    \`);
    console.log("Tabla productos lista");
  } catch (err) {
    console.error("Error creando tabla:", err.message);
  }
}

// funcion para autenticarse en shopify (porque la tienda tiene contraseña)
async function loginShopify() {
  try {
    const pagina = await axios.get(SHOPIFY_URL + "/password", {
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
    });

    const cookies = pagina.headers["set-cookie"];
    const cookieStr = cookies ? cookies.map((c) => c.split(";")[0]).join("; ") : "";

    // sacar el token del formulario
    const $ = cheerio.load(pagina.data);
    const token = $('input[name="authenticity_token"]').val() || $('form input[type="hidden"]').first().val();

    // mandar la contraseña
    const login = await axios.post(
      SHOPIFY_URL + "/password",
      new URLSearchParams({
        authenticity_token: token || "",
        password: PASS,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieStr,
        },
        maxRedirects: 0,
        validateStatus: (s) => s < 400 || s === 302,
      }
    );

    const nuevasCookies = login.headers["set-cookie"];
    if (nuevasCookies) {
      return [...(cookies || []), ...nuevasCookies].map((c) => c.split(";")[0]).join("; ");
    }
    return cookieStr;
  } catch (err) {
    console.error("No se pudo autenticar en Shopify:", err.message);
    return "";
  }
}

// sacar las urls de productos del sitemap
async function getProductosDelSitemap(cookies) {
  try {
    const resp = await axios.get(SHOPIFY_URL + "/sitemap.xml", {
      headers: { Cookie: cookies },
    });

    const $ = cheerio.load(resp.data, { xmlMode: true });
    let urls = [];

    // primero buscar si hay sub-sitemaps de productos
    let sitemaps = [];
    $("sitemap loc").each((i, el) => {
      const url = $(el).text();
      if (url.includes("products")) sitemaps.push(url);
    });

    if (sitemaps.length > 0) {
      for (const sm of sitemaps) {
        const r = await axios.get(sm, { headers: { Cookie: cookies } });
        const s = cheerio.load(r.data, { xmlMode: true });
        s("url loc").each((i, el) => urls.push(s(el).text()));
      }
    } else {
      // buscar directamente
      $("url loc").each((i, el) => {
        const url = $(el).text();
        if (url.includes("/products/")) urls.push(url);
      });
    }

    console.log("Productos encontrados en sitemap:", urls.length);
    return urls;
  } catch (err) {
    console.error("Error con el sitemap:", err.message);
    return [];
  }
}

// scrapear la info de un producto
async function scrapearProducto(url, cookies) {
  try {
    const resp = await axios.get(url, { headers: { Cookie: cookies } });
    const $ = cheerio.load(resp.data);

    let titulo = $('meta[property="og:title"]').attr("content")
      || $("h1").first().text().trim()
      || $("title").text().trim();

    let precio = $('meta[property="og:price:amount"]').attr("content")
      || $('meta[property="product:price:amount"]').attr("content")
      || $(".price__regular .price-item--regular").first().text().trim()
      || $(".product-price").first().text().trim()
      || $(".price").first().text().trim()
      || $('[class*="price"]').first().text().trim()
      || "N/A";

    precio = precio.replace(/\s+/g, " ").trim();

    let imagen = $('meta[property="og:image"]').attr("content")
      || $(".product__media img").first().attr("src")
      || $(".product-featured-image").first().attr("src")
      || $('img[class*="product"]').first().attr("src")
      || "";

    if (imagen.startsWith("//")) imagen = "https:" + imagen;

    return { titulo: titulo || "Sin titulo", precio, imagen, url };
  } catch (err) {
    console.error("Error scrapeando " + url + ":", err.message);
    return null;
  }
}

// funcion principal de scraping
async function hacerScraping() {
  console.log("Iniciando scraping...");

  // primero nos autenticamos
  const cookies = await loginShopify();

  // intentamos sacar productos del sitemap
  let urls = await getProductosDelSitemap(cookies);

  // si el sitemap no tiene productos, usamos products.json
  if (urls.length === 0) {
    console.log("Sitemap vacio, intentando con products.json...");
    try {
      const resp = await axios.get(SHOPIFY_URL + "/products.json", {
        headers: { Cookie: cookies },
      });
      const prods = resp.data.products || [];
      console.log("Productos encontrados via JSON:", prods.length);

      await pool.query("DELETE FROM productos");

      for (const p of prods) {
        await pool.query(
          "INSERT INTO productos (titulo, precio, imagen, url) VALUES ($1, $2, $3, $4)",
          [p.title, p.variants?.[0]?.price || "N/A", p.images?.[0]?.src || "", SHOPIFY_URL + "/products/" + p.handle]
        );
        console.log("  Guardado:", p.title);
      }

      const total = await pool.query("SELECT COUNT(*) FROM productos");
      console.log("Scraping terminado. Total:", total.rows[0].count);
      return { success: true, total: parseInt(total.rows[0].count) };
    } catch (err) {
      console.error("Error con products.json:", err.message);
    }
  }

  // si sacamos urls del sitemap, scrapear cada producto
  if (urls.length > 0) {
    await pool.query("DELETE FROM productos");

    for (const url of urls) {
      const prod = await scrapearProducto(url, cookies);
      if (prod) {
        await pool.query(
          "INSERT INTO productos (titulo, precio, imagen, url) VALUES ($1, $2, $3, $4)",
          [prod.titulo, prod.precio, prod.imagen, prod.url]
        );
        console.log("  Guardado:", prod.titulo);
      }
    }

    const total = await pool.query("SELECT COUNT(*) FROM productos");
    console.log("Scraping terminado. Total:", total.rows[0].count);
    return { success: true, total: parseInt(total.rows[0].count) };
  }

  return { success: false, total: 0, message: "No se encontraron productos" };
}

// --- ENDPOINTS ---

// ver todos los productos
app.get("/productos", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM productos ORDER BY id ASC");
    res.json({
      success: true,
      total: result.rows.length,
      productos: result.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ejecutar el scraping
app.get("/scrape", async (req, res) => {
  try {
    const resultado = await hacerScraping();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ruta principal
app.get("/", (req, res) => {
  res.json({
    mensaje: "Servidor activo - Shopify a Neon",
    endpoints: {
      "/productos": "Ver todos los productos",
      "/scrape": "Ejecutar scraping de Shopify",
    },
  });
});

// iniciar el servidor (solo cuando corremos local, en vercel no hace falta)
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log("Servidor corriendo en http://localhost:" + PORT);
    console.log("Endpoints:");
    console.log("  GET /productos");
    console.log("  GET /scrape");
    await crearTabla();
  });
}

// exportar para vercel
module.exports = app;
