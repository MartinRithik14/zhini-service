// services/r2.service.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

export const uploadToR2 = async (file, options = {}) => {
  if (!file || !(file instanceof File)) return null;

  // Extract folder and optional homeId
  const { homeId, folder = "product-images" } = typeof options === "string" 
    ? { folder: options } 
    : options;

  const fileExtension = file.name.split(".").pop() || "jpg";
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

  // Build key: homes/<homeId>/<uniqueName> or homes/<homeId>/<folder>/<uniqueName>
  let keyPrefix = "";
  if (homeId) {
    keyPrefix = folder ? `homes/${homeId}/${folder}` : `homes/${homeId}`;
  } else {
    keyPrefix = folder || "uploads";
  }

  const fileName = `${keyPrefix}/${uniqueName}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || "zhini-prod",
    Key: fileName,
    Body: buffer,
    ContentType: file.type || "image/jpeg",
  });

  await r2Client.send(command);

  const publicBaseUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  return `${publicBaseUrl}/${fileName}`;
};