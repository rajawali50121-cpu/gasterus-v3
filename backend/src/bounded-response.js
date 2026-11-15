function responseSizeError(label, maxBytes, actualBytes = null) {
  const detail = actualBytes === null ? `exceeds ${maxBytes} bytes` : `exceeds ${maxBytes} bytes (${actualBytes} bytes)`;
  return new Error(`${label} response ${detail}`);
}

export async function readBoundedResponseText(response, label, maxBytes) {
  const unlimited = !Number.isFinite(maxBytes) || maxBytes <= 0;
  const contentLength = response.headers?.get?.('content-length')?.trim();
  if (!unlimited && /^\d+$/.test(contentLength || '') && Number(contentLength) > maxBytes) {
    if (response.body) await response.body.cancel();
    throw responseSizeError(label, maxBytes, Number(contentLength));
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    const responseBytes = Buffer.byteLength(text, 'utf8');
    if (!unlimited && responseBytes > maxBytes) throw responseSizeError(label, maxBytes, responseBytes);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (!unlimited && totalBytes > maxBytes) {
      await reader.cancel();
      throw responseSizeError(label, maxBytes, totalBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
