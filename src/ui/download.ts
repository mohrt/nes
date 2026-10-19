/** Saves bytes to the user's downloads folder under `filename`. */
export function downloadFile(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
