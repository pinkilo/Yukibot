export type CallRecord = {
  type: `${"insert" | "list" | "get"}/${string}`
  success: boolean
  /** Local machine time */
  time: Date
}

export default abstract class ApiHandler {
  /** A record of each API call made, most recent -> oldest */
  protected readonly calls: CallRecord[]

  protected constructor() {
    this.calls = []
  }

  /** A record of each API call made, most recent -> oldest */
  get callHistory(): CallRecord[] {
    return this.calls
  }
}
