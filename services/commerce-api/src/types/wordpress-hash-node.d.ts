declare module "wordpress-hash-node" {
  export function HashPassword(password: string): string;
  export function CheckPassword(password: string, hash: string): boolean;
}
