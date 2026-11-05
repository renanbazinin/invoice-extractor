/** A failure the caller can act on (ask for a password, report an unreadable file). */
export class ReadError extends Error {
  readonly code: 'password-required' | 'password-incorrect' | 'invalid-input' | 'unsupported'
  constructor(code: ReadError['code'], message: string) {
    super(message)
    this.name = 'ReadError'
    this.code = code
  }
}
