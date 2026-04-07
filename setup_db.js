// setup_db.js - crear la tabla en neon
// ejecutar una vez: node setup_db.js

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_aeP1vj5QFrfn@ep-tiny-block-am1y4k1v-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false },
});

async function setup() {
  const client = await pool.connect();
  try {
    console.log("Conectado a Neon");

    await client.query(\`
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(500),
        precio VARCHAR(100),
        imagen TEXT,
        url TEXT,
        fecha_scraping TIMESTAMP DEFAULT NOW()
      )
    \`);
    console.log("Tabla productos creada");

    const res = await client.query("SELECT COUNT(*) FROM productos");
    console.log("Productos en la tabla:", res.rows[0].count);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    client.release();
    await pool.end();
    console.log("Listo");
  }
}

setup();
