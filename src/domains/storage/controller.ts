import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  confirmReelUploadPaths,
  createSignedUploadUrls,
  downloadQaReportHtml,
  uploadQaReportHtml,
  uploadShopImage as uploadShopImageToStorage,
} from './service';
import { processReelUpload, enqueueReelVideoJob } from '../../services/reelsMedia.service';
import { updateShop } from '../shops/service';

const isImage = (type: string) => type.startsWith('image/');
const isVideo = (type: string) => type.startsWith('video/');

const guessContentType = (fileName: string) => {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.webm') return 'video/webm';
  return '';
};

const resolveContentType = (file: any) => {
  const raw = String(file?.contentType || '').trim();
  if (raw) return raw;
  return guessContentType(String(file?.fileName || ''));
};

export const createReelUploadUrls = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const { shopId, type, files } = req.body || {};
  if (!shopId) {
    return res.status(400).json({ message: 'shopId requerido.' });
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId !== shopId) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  if (req.auth.userType !== 'SHOP' && req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }

  const normalizedType = type === 'PHOTO_SET' ? 'PHOTO_SET' : 'VIDEO';
  const normalizedFiles = Array.isArray(files)
    ? files.map((file: any) => ({
        ...file,
        contentType: resolveContentType(file),
      }))
    : [];
  if (!normalizedFiles.length) {
    return res.status(400).json({ message: 'Debes subir al menos un archivo.' });
  }

  if (normalizedType === 'VIDEO') {
    if (normalizedFiles.length !== 1) {
      return res.status(400).json({ message: 'Solo se permite un video por reel.' });
    }
    if (!isVideo(normalizedFiles[0]?.contentType || '')) {
      return res.status(400).json({ message: 'El archivo debe ser un video.' });
    }
  }

  if (normalizedType === 'PHOTO_SET') {
    if (normalizedFiles.length > 5) {
      return res.status(400).json({ message: 'Maximo 5 fotos por reel.' });
    }
    const invalid = normalizedFiles.find((file: any) => !isImage(file?.contentType || ''));
    if (invalid) {
      return res.status(400).json({ message: 'Las fotos deben ser imagenes.' });
    }
  }

  try {
    const payload = normalizedFiles.map((file: any) => ({
      fileName: file?.fileName || 'upload',
      contentType: file?.contentType || 'application/octet-stream',
    }));
    const data = await createSignedUploadUrls(shopId, payload);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'No se pudo generar URLs de subida.' });
  }
};

export const confirmReelUpload = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const { shopId, type, paths } = req.body || {};
  if (!shopId) {
    return res.status(400).json({ message: 'shopId requerido.' });
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId !== shopId) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  if (req.auth.userType !== 'SHOP' && req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }

  const normalizedType = type === 'PHOTO_SET' ? 'PHOTO_SET' : 'VIDEO';
  const normalizedPaths = Array.isArray(paths)
    ? paths.map((item: any) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!normalizedPaths.length) {
    return res.status(400).json({ message: 'Debes confirmar al menos un archivo.' });
  }
  if (normalizedType === 'VIDEO' && normalizedPaths.length !== 1) {
    return res.status(400).json({ message: 'Solo se permite un video por reel.' });
  }
  if (normalizedType === 'PHOTO_SET' && normalizedPaths.length > 5) {
    return res.status(400).json({ message: 'Maximo 5 fotos por reel.' });
  }

  try {
    const data = await confirmReelUploadPaths({
      shopId,
      type: normalizedType,
      paths: normalizedPaths,
    });
    return res.json(data);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'No se pudieron confirmar los archivos.' });
  }
};

export const uploadReelMedia = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const { shopId, type, editorState } = req.body || {};
  if (!shopId) {
    return res.status(400).json({ message: 'shopId requerido.' });
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId !== shopId) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  if (req.auth.userType !== 'SHOP' && req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }

  const normalizedType = type === 'PHOTO_SET' ? 'PHOTO_SET' : 'VIDEO';
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({ message: 'Debes subir al menos un archivo.' });
  }
  if (normalizedType === 'VIDEO') {
    if (files.length !== 1) {
      return res.status(400).json({ message: 'Solo se permite un video por reel.' });
    }
    if (!isVideo(files[0]?.mimetype || '')) {
      return res.status(400).json({ message: 'El archivo debe ser un video.' });
    }
  }
  if (normalizedType === 'PHOTO_SET') {
    if (files.length > 5) {
      return res.status(400).json({ message: 'Maximo 5 fotos por reel.' });
    }
    const invalid = files.find((file: any) => !isImage(file?.mimetype || ''));
    if (invalid) {
      return res.status(400).json({ message: 'Las fotos deben ser imagenes.' });
    }
  }

  try {
    if (normalizedType === 'VIDEO') {
      const file = files[0] as Express.Multer.File;
      const sizeMb = file?.size ? file.size / (1024 * 1024) : 0;
      const asyncThresholdMb = Number(process.env.REEL_ASYNC_THRESHOLD_MB || 12);
      if (sizeMb >= asyncThresholdMb) {
        const jobId = await enqueueReelVideoJob(shopId, file);
        return res.json({ processing: true, jobId });
      }
    }

    const payload = await processReelUpload({
      shopId,
      type: normalizedType,
      files: files as Express.Multer.File[],
      editorState,
    });
    res.json(payload);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'No se pudo procesar el reel.' });
  }
};

export const uploadShopImage = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const { shopId, type } = req.body || {};
  const normalizedType = type === 'COVER' ? 'COVER' : 'LOGO';
  if (req.auth.userType !== 'SHOP' && req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }
  const effectiveShopId = req.auth.userType === 'SHOP' ? req.auth.shopId : shopId;
  if (!effectiveShopId) {
    return res.status(400).json({ message: 'shopId requerido.' });
  }

  const file = Array.isArray(req.files) ? req.files[0] : req.file;
  if (!file) {
    return res.status(400).json({ message: 'Archivo requerido.' });
  }
  if (!isImage(file.mimetype || '')) {
    return res.status(400).json({ message: 'La imagen debe ser formato válido.' });
  }

  try {
    const publicUrl = await uploadShopImageToStorage({
      shopId: effectiveShopId,
      type: normalizedType,
      file: file as Express.Multer.File,
    });
    const cacheBustedUrl = `${publicUrl}?v=${Date.now()}`;
    const updatedShop = await updateShop(effectiveShopId, {
      [normalizedType === 'COVER' ? 'coverUrl' : 'logoUrl']: cacheBustedUrl,
    });
    res.json({ url: cacheBustedUrl, shop: updatedShop });
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'No se pudo subir la imagen.' });
  } finally {
    if (file?.path) {
      await fs.unlink(file.path).catch(() => undefined);
    }
  }
};

export const uploadReportHtml = async (req: Request, res: Response) => {
  const expectedToken = (process.env.QA_REPORT_UPLOAD_TOKEN || '').trim();
  if (expectedToken) {
    const incomingToken = String(req.headers['x-qa-report-token'] || '').trim();
    if (!incomingToken || incomingToken !== expectedToken) {
      return res.status(401).json({ message: 'Token QA invalido.' });
    }
  }

  const file = Array.isArray(req.files) ? req.files[0] : req.file;
  if (!file) {
    return res.status(400).json({ message: 'Archivo HTML requerido.' });
  }

  const fileName = String(file.originalname || '').toLowerCase();
  const isHtml =
    file.mimetype.includes('text/html') || fileName.endsWith('.html') || fileName.endsWith('.htm');
  if (!isHtml) {
    return res.status(400).json({ message: 'Solo se admite archivo .html.' });
  }

  const role = typeof req.body?.role === 'string' ? req.body.role : 'general';
  const testerName = typeof req.body?.testerName === 'string' ? req.body.testerName : 'tester';

  try {
    const uploaded = await uploadQaReportHtml({
      file: file as Express.Multer.File,
      role,
      testerName,
    });

    const backendBaseUrl =
      (process.env.PUBLIC_BACKEND_URL || '').trim() || `${req.protocol}://${req.get('host')}`;
    const viewUrl = `${backendBaseUrl.replace(/\/+$/, '')}/storage/reports/view?path=${encodeURIComponent(uploaded.path)}`;

    return res.json({
      url: viewUrl,
      rawUrl: uploaded.publicUrl,
      bucket: uploaded.bucket,
      path: uploaded.path,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'No se pudo subir el reporte HTML.' });
  } finally {
    if (file?.path) {
      await fs.unlink(file.path).catch(() => undefined);
    }
  }
};

export const viewReportHtml = async (req: Request, res: Response) => {
  const rawPath = String(req.query?.path || '').trim();
  if (!rawPath) {
    return res.status(400).send('path requerido');
  }

  try {
    const report = await downloadQaReportHtml(rawPath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(report.html);
  } catch (error: any) {
    return res.status(404).send(error?.message || 'No se pudo abrir el reporte HTML.');
  }
};
