import { Router } from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';
import multer from 'multer';
import * as StorageController from '../domains/storage/controller';

const router = Router();
const uploadDir = path.join(os.tmpdir(), 'avellaneda-reels-upload');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 },
});

router.post('/reels/upload-url', StorageController.createReelUploadUrls);
router.post('/reels/confirm', StorageController.confirmReelUpload);
router.post('/reels/upload', upload.array('files', 5), StorageController.uploadReelMedia);
router.post('/shops/upload', upload.single('file'), StorageController.uploadShopImage);
router.post('/reports/upload', upload.single('file'), StorageController.uploadReportHtml);

export default router;

