// Files imported as text (`import x from '…' with { type: 'text' }`) – Bun inlines them, also into the executable.
declare module '*.sh' {
  const text: string;
  export default text;
}
declare module '*.service' {
  const text: string;
  export default text;
}
declare module '*.example' {
  const text: string;
  export default text;
}
