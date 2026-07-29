declare module 'png-chunks-extract' {
  interface PngChunk {
    name: string;
    data: Uint8Array;
  }
  function extractChunks(data: Uint8Array): PngChunk[];
  export = extractChunks;
}
