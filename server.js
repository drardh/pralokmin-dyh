const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const JSZip = require('jszip');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Buat folder uploads jika belum ada
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
  console.log('📁 Folder uploads dibuat.');
}

// Konfigurasi Multer untuk menyimpan file di disk
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { bulan, klaster } = req.body;
    // Buat folder berdasarkan bulan dan klaster
    const dir = path.join(uploadDir, bulan, `klaster${klaster}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Gunakan nama asli file
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file PDF yang diperbolehkan'), false);
    }
  }
}).fields([
  { name: 'undangan', maxCount: 1 },
  { name: 'notulen', maxCount: 1 },
  { name: 'lampiran', maxCount: 1 }
]);

// ---------- ENDPOINT UPLOAD ----------
app.post('/api/upload', (req, res, next) => {
  // Multer akan memproses file
  upload(req, res, function (err) {
    if (err) {
      // Jika error dari multer
      return res.status(400).json({ success: false, error: err.message });
    }
    // Lanjut ke proses penyimpanan metadata
    processUpload(req, res);
  });
});

async function processUpload(req, res) {
  try {
    const { bulan, klaster } = req.body;
    const files = req.files;

    // Validasi dasar
    if (!bulan || !klaster) {
      return res.status(400).json({ success: false, error: 'Bulan dan Klaster wajib diisi' });
    }

    // Daftar jenis file yang diizinkan
    const jenisMap = {
      undangan: 'undangan',
      notulen: 'notulen',
      lampiran: 'lampiran'
    };

    // Mulai transaksi SQLite
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      for (const [key, fileArray] of Object.entries(files)) {
        const jenis = jenisMap[key];
        if (!jenis) continue;
        const file = fileArray[0]; // karena maxCount=1
        const pathFile = path.join('uploads', bulan, `klaster${klaster}`, file.originalname);

        // Gunakan INSERT OR REPLACE untuk update jika sudah ada
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO pralokmin (bulan, klaster, jenis, nama_file, path_file, ukuran)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(bulan, klaster, jenis, file.originalname, pathFile, file.size);
        stmt.finalize();
      }

      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'Upload berhasil' });
      });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------- ENDPOINT STATUS PER BULAN ----------
app.get('/api/status/:bulan', (req, res) => {
  const bulan = req.params.bulan;
  db.all(`
    SELECT klaster, jenis, nama_file, path_file, ukuran, diupload_pada
    FROM pralokmin WHERE bulan = ?
  `, [bulan], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Bentuk response: { "1": { undangan: true/false, ... }, ... }
    const result = {};
    for (let i = 1; i <= 5; i++) {
      result[i] = { undangan: false, notulen: false, lampiran: false };
    }

    rows.forEach(row => {
      result[row.klaster][row.jenis] = true;
    });

    res.json(result);
  });
});

// ---------- ENDPOINT DOWNLOAD ZIP ----------
app.get('/api/download/:bulan', async (req, res) => {
  const bulan = req.params.bulan;

  db.all(`
    SELECT klaster, jenis, path_file, nama_file
    FROM pralokmin WHERE bulan = ?
  `, [bulan], async (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tidak ada file untuk bulan ini' });
    }

    const zip = new JSZip();
    const basePath = path.join(__dirname);

    // Loop untuk menambahkan file ke ZIP
    for (const row of rows) {
      const fullPath = path.join(basePath, row.path_file);
      if (!fs.existsSync(fullPath)) {
        continue; // skip jika file hilang
      }
      const content = fs.readFileSync(fullPath);
      const folderName = `Klaster_${row.klaster}`;
      zip.folder(folderName).file(row.nama_file, content);
    }

    try {
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename=Pralokmin_${bulan}.zip`);
      res.send(zipBuffer);
    } catch (zipErr) {
      res.status(500).json({ error: 'Gagal membuat ZIP' });
    }
  });
});

// ---------- ENDPOINT AMBIL DETAIL FILE PER KLASTER ----------
app.get('/api/files/:bulan/:klaster', (req, res) => {
  const { bulan, klaster } = req.params;
  db.all(`
    SELECT jenis, nama_file, path_file, ukuran, diupload_pada
    FROM pralokmin
    WHERE bulan = ? AND klaster = ?
  `, [bulan, klaster], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ---------- ENDPOINT DOWNLOAD FILE INDIVIDU ----------
app.get('/api/download-file/:bulan/:klaster/:jenis', (req, res) => {
  const { bulan, klaster, jenis } = req.params;
  db.get(`
    SELECT path_file, nama_file
    FROM pralokmin
    WHERE bulan = ? AND klaster = ? AND jenis = ?
  `, [bulan, klaster, jenis], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'File tidak ditemukan' });
    }
    const filePath = path.join(__dirname, row.path_file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File fisik tidak ditemukan' });
    }
    res.download(filePath, row.nama_file);
  });
});

// ---------- ENDPOINT HAPUS FILE ----------
app.delete('/api/file/:bulan/:klaster/:jenis', (req, res) => {
  const { bulan, klaster, jenis } = req.params;
  // Ambil path_file dulu
  db.get(`
    SELECT path_file FROM pralokmin
    WHERE bulan = ? AND klaster = ? AND jenis = ?
  `, [bulan, klaster, jenis], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'File tidak ditemukan' });
    }

    // Hapus file fisik
    const filePath = path.join(__dirname, row.path_file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Hapus metadata dari database
    db.run(`
      DELETE FROM pralokmin
      WHERE bulan = ? AND klaster = ? AND jenis = ?
    `, [bulan, klaster, jenis], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, message: 'File berhasil dihapus' });
    });
  });
});

// ---------- START SERVER ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`📱 Akses dari perangkat lain: http://<IP-server>:${PORT}`);
});

