import sharp from "sharp";
import { AppError } from "./config";
export interface FileNormalizer { normalize(bytes: Buffer, mime: string): Promise<Buffer> }
export const imageNormalizer: FileNormalizer = {
  async normalize(bytes, mime) {
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new AppError("请选择不超过 10 MB 的 JPG 或 PNG 图片。", 422);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((!jpeg && !png) || (mime && !["image/jpeg", "image/png", "application/octet-stream"].includes(mime))) throw new AppError("初版支持 JPG 和 PNG，请转换图片后重试。", 422);
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < 120) throw new Error("too_small");
      return await image.rotate().flatten({ background: "white" }).resize({ width: 2400, height: 3200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    } catch { throw new AppError("图片无法读取或尺寸过小，请换一张清晰完整的照片。", 422); }
  },
};
