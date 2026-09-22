const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const fileType = file.fieldname; // 'cheque' ou 'recu'
    cb(null, `batch_${req.params.id}_${fileType}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

module.exports = { upload, uploadDir };
