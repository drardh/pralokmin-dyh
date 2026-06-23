const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Tentukan lokasi file database
const dbPath = path.join(__dirname, 'pralokmin.db');

// Buat koneksi (jika file db belum ada, akan dibuat otomatis)
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Gagal koneksi ke SQLite:', err.message);
  } else {
    console.log('✅ Terhubung ke SQLite database:', dbPath);
  }
});

// Buat tabel jika belum ada (migrasi sederhana)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pralokmin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bulan TEXT NOT NULL,               -- format: YYYY-MM
      klaster INTEGER NOT NULL CHECK (klaster BETWEEN 1 AND 5),
      jenis TEXT NOT NULL CHECK (jenis IN ('undangan','notulen','lampiran')),
      nama_file TEXT NOT NULL,
      path_file TEXT NOT NULL,
      ukuran INTEGER,
      diupload_pada DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bulan, klaster, jenis)      -- mencegah duplikasi per jenis
    )
  `, (err) => {
    if (err) {
      console.error('❌ Gagal membuat tabel:', err.message);
    } else {
      console.log('✅ Tabel pralokmin siap digunakan.');
    }
  });
});

module.exports = db;