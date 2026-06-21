/// <reference types="vite/client" />

// `?worker&url` yields the bundled worker's URL as a string (not covered by
// vite/client's built-in ambient declarations).
declare module "*?worker&url" {
  const url: string;
  export default url;
}
