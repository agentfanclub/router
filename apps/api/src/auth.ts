import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { Resend } from "resend";
import * as schema from "./db/schema";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
};

// Match the NetID form as well as the exact domain. Subdomains and aliases are excluded.
export function isIllinoisEmail(email: string) {
  return /^[a-z][a-z0-9]*@illinois\.edu$/i.test(email);
}

export function createAuth(env: AuthEnv) {
  const resend = new Resend(env.RESEND_API_KEY);
  const failedDeliveries = new WeakSet<Request>();
  const sendEmail = async (email: string, subject: string, text: string) => {
    if (!isIllinoisEmail(email)) {
      throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
    }
    const { error } = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: email,
      subject,
      text,
    });
    if (error) {
      // Do not log links, codes, or provider responses containing recipient details.
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "We couldn't send your email. Please try again." });
    }
  };

  return betterAuth({
    appName: "Router",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 5 },
      },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type !== "sign-in") {
          throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are supported." });
        }
        for (const field of ["email", "newEmail"]) {
          const email = ctx.body?.[field];
          if (typeof email === "string" && !isIllinoisEmail(email)) {
            throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Better Auth catches OTP delivery errors internally. Return a failure to
        // the caller so the form does not claim a code was sent when Resend failed.
        if (ctx.request && failedDeliveries.has(ctx.request)) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "We couldn't send your email. Please try again." });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: { before: async (user) => {
          if (!isIllinoisEmail(user.email)) {
            throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
          }
        } },
        update: { before: async (user) => {
          if (user.email && !isIllinoisEmail(user.email)) {
            throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
          }
        } },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(email, "Sign in to Router", `Sign in to Router:\n\n${url}\n\nThis link expires in 5 minutes. If you didn't request it, ignore this email.`);
        },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }, ctx) => {
          if (type !== "sign-in") {
            throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are supported." });
          }
          try {
            await sendEmail(email, "Your Router sign-in code", `Your Router sign-in code is ${otp}.\n\nIt expires in 5 minutes. If you didn't request it, ignore this email.`);
          } catch (error) {
            if (!ctx?.request) throw error;
            failedDeliveries.add(ctx.request);
          }
        },
      }),
    ],
  });
}
