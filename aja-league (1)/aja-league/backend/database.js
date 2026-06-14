const { Pool } = require("pg");

console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const db = {
  get(sql, params = [], callback) {
    const convertedSql = convertPlaceholders(sql);

    pool.query(convertedSql, params)
      .then(result => callback(null, result.rows[0]))
      .catch(err => {
        console.error("DB GET ERROR:", err.message);
        callback(err);
      });
  },

  all(sql, params = [], callback) {
    const convertedSql = convertPlaceholders(sql);

    pool.query(convertedSql, params)
      .then(result => callback(null, result.rows))
      .catch(err => {
        console.error("DB ALL ERROR:", err.message);
        callback(err);
      });
  },

  run(sql, params = [], callback = () => {}) {
    const convertedSql = convertPlaceholders(sql);

    pool.query(convertedSql, params)
      .then(result => callback.call({ changes: result.rowCount }, null))
      .catch(err => {
        console.error("DB RUN ERROR:", err.message);
        console.error("SQL:", convertedSql);
        console.error("PARAMS:", params);
        callback(err);
      });
  }
};

module.exports = db;