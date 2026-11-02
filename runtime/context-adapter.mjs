#!/usr/bin/env node
/**
 * Context & Vision Adapter ("Đôi Mắt" của Agent)
 * Part of Agent Runtime (agent-team/runtime/context-adapter.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeOrThrow, resolveRepoRoot } from '../scripts/applier.mjs';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB hard limit
export const MAX_TEXT_FILE_LINES = 500;

const FORBIDDEN_ATTACHMENT_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /\.git[/\\]/i,
  /credentials\.json/i,
  /secrets?\.json/i
];

/**
 * Checks if a relative path targets sensitive secret files.
 */
export function isForbiddenAttachment(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pat of FORBIDDEN_ATTACHMENT_PATTERNS) {
    if (pat.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Encodes a local image (.png, .jpg, .webp) into an OpenAI multimodal image_url payload.
 */
export function encodeImageAttachment(repoRoot, imageRelativePath) {
  const safeRelPath = normalizeOrThrow(repoRoot, imageRelativePath);
  const fullPath = path.resolve(repoRoot, safeRelPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Image attachment not found: ${safeRelPath}`);
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Target image path is not a file: ${safeRelPath}`);
  }

  if (stat.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Image ${safeRelPath} exceeds maximum limit of 5MB (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  const ext = path.extname(safeRelPath).toLowerCase();
  let mimeType = '';

  switch (ext) {
    case '.png':
      mimeType = 'image/png';
      break;
    case '.jpg':
    case '.jpeg':
      mimeType = 'image/jpeg';
      break;
    case '.webp':
      mimeType = 'image/webp';
      break;
    default:
      throw new Error(`Unsupported image format: "${ext}". Supported formats: .png, .jpg, .jpeg, .webp`);
  }

  const base64Data = fs.readFileSync(fullPath).toString('base64');
  const dataUri = `data:${mimeType};base64,${base64Data}`;

  return {
    rel_path: safeRelPath,
    bytes: stat.size,
    mime_type: mimeType,
    payload: {
      type: 'image_url',
      image_url: {
        url: dataUri
      }
    }
  };
}

/**
 * Safely reads a workspace text file for prompt attachment.
 */
export function readTextAttachment(repoRoot, fileRelativePath, maxLines = MAX_TEXT_FILE_LINES) {
  const safeRelPath = normalizeOrThrow(repoRoot, fileRelativePath);

  if (isForbiddenAttachment(safeRelPath)) {
    throw new Error(`Access denied to sensitive or secret file: ${safeRelPath}`);
  }

  const fullPath = path.resolve(repoRoot, safeRelPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Text attachment file not found: ${safeRelPath}`);
  }

  const raw = fs.readFileSync(fullPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  if (lines.length <= maxLines) {
    return {
      rel_path: safeRelPath,
      lines_count: lines.length,
      truncated: false,
      content: raw
    };
  }

  const sliced = lines.slice(0, maxLines).join('\n');
  return {
    rel_path: safeRelPath,
    lines_count: lines.length,
    truncated: true,
    content: `${sliced}\n\n[... Truncated: showing first ${maxLines} of ${lines.length} lines. Use read_file tool to inspect specific line ranges ...]`
  };
}

/**
 * Builds the user message payload (supporting text-only or OpenAI multimodal content array).
 */
export function buildUserMessage(options = {}) {
  const {
    prompt = '',
    images = [],
    files = [],
    repoRoot = resolveRepoRoot(),
    modelCapabilities = {}
  } = options;

  let textAcc = prompt.trim();

  // Attach text files if provided
  if (Array.isArray(files) && files.length > 0) {
    const fileBlocks = [];
    for (const f of files) {
      try {
        const textAtt = readTextAttachment(repoRoot, f);
        fileBlocks.push(
          `<attached_file path="${textAtt.rel_path}">\n${textAtt.content}\n</attached_file>`
        );
      } catch (err) {
        fileBlocks.push(
          `<attached_file path="${f}" error="${err.message}">[Failed to attach file: ${err.message}]</attached_file>`
        );
      }
    }
    if (fileBlocks.length > 0) {
      textAcc = `${textAcc}\n\n=== ATTACHED FILES (${fileBlocks.length}) ===\n${fileBlocks.join('\n\n')}`;
    }
  }

  // Handle images
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!hasImages) {
    return {
      role: 'user',
      content: textAcc
    };
  }

  // If model doesn't support vision, throw informative error early
  if (modelCapabilities.supports_vision === false) {
    throw new Error(
      `Model does not support vision/image attachments (supports_vision: false). Cannot attach images: ${images.join(', ')}`
    );
  }

  const contentArray = [
    {
      type: 'text',
      text: textAcc
    }
  ];

  for (const imgPath of images) {
    const encoded = encodeImageAttachment(repoRoot, imgPath);
    contentArray.push(encoded.payload);
  }

  return {
    role: 'user',
    content: contentArray
  };
}
