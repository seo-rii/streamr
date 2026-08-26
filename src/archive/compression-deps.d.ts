declare module "@openpgp/unbzip2-stream" {
  export default function unbzip2Stream(
    input: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array>;
}
