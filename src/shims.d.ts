declare var process: any;
declare var Buffer: any;
declare namespace NodeJS {
  interface ProcessEnv { [key: string]: string | undefined; }
}

declare module "node:fs" {
  export const createWriteStream: any;
  export const existsSync: any;
  export const mkdirSync: any;
  export const readFileSync: any;
  export const statSync: any;
  export const writeFileSync: any;
  export const rmSync: any;
  export const readdirSync: any;
}

declare module "node:path" {
  export const dirname: any;
  export const resolve: any;
  export const join: any;
  export const relative: any;
}

declare module "node:child_process" {
  export const spawn: any;
}

declare module "node:os" {
  export const homedir: any;
}
