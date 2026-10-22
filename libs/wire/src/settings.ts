// A server's settings as its page edits them (GET/PUT /api/settings on every server): the fields the server
// describes, and their values. A field's key is a path into the server's settings ("source.url"). The server keeps
// them in its SQLite file and applies a change at once.

export type FieldType =
  | "text" | "secret"     // a string (a secret is shown hidden)
  | "url"                 // http(s)://host[:port]
  | "number" | "port"     // a number (a port: an integer 0–65535)
  | "bool"
  | "lines"               // a list of strings, one per line
  | "select"              // one of `options` ("" for none, if `options` has it)
  | "json";               // an object, edited as JSON

export interface SettingField {
  key: string; label: string; type: FieldType; help?: string; group?: string;
  options?: string[]; min?: number; max?: number;
}

export interface SettingsView { fields: SettingField[]; values: Record<string, unknown> }

/** a PUT's answer: the settings now, and where the server listens if that changed (the page follows it there) */
export interface SettingsSaved extends SettingsView { moved?: { host: string; port: number } }
