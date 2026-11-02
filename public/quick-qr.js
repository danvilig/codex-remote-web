import qrcode from 'qrcode-generator';
export function temporaryQr(url) {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(url)) throw new Error('Invalid temporary address');
  const code = qrcode(0, 'M'); code.addData(url, 'Byte'); code.make();
  return code.createSvgTag({ cellSize:4, margin:16, scalable:true });
}
