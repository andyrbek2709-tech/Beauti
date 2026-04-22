import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config";

export interface AdminClaims {
  adminId: string;
  salonId: string;
  email: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAdminToken(claims: AdminClaims): string {
  return jwt.sign(claims, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "7d"
  });
}

export function verifyAdminToken(token: string): AdminClaims {
  return jwt.verify(token, config.jwtSecret) as AdminClaims;
}
