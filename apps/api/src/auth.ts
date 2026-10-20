import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { Resend } from "resend";
import * as schema from "./db/schema";
import type { ApiEnv } from "./env";

// Match the NetID form as well as the exact domain. Subdomains and aliases are excluded.
export function isIllinoisEmail(email: string) {
  return /^[a-z][a-z0-9]*@illinois\.edu$/i.test(email);
}

export function createAuth(env: ApiEnv) {
  const resend = new Resend(env.RESEND_API_KEY);
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

  const otpPlugin = emailOTP({
    disableSignUp: false,
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 5,
    storeOTP: "hashed",
    // Sign-in emails are sent by the magic link plugin with both credentials.
    sendVerificationOTP: async () => {
      throw new APIError("NOT_FOUND", { message: "Not found." });
    },
  });

  return betterAuth({
    appName: "Router",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: false },
    socialProviders: {
      microsoft: {
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        tenantId: env.MICROSOFT_TENANT_ID,
        prompt: "select_account",
        disableProfilePhoto: true,
        disableDefaultScope: true,
        scope: ["openid", "profile", "email"],
        mapProfileToUser: (profile) => {
          // Use the university sign-in name, not a configurable contact email.
          const email = profile.preferred_username?.toLowerCase();
          if (profile.tid !== env.MICROSOFT_TENANT_ID || !email || !isIllinoisEmail(email)) {
            throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID account." });
          }
          // Trust the NetID asserted by the university tenant after token validation.
          return { email, emailVerified: true };
        },
      },
    },
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    rateLimit: { enabled: false },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Expose only the supported sign-in flows and session management.
        if (![
          "/sign-in/magic-link",
          "/magic-link/verify",
          "/sign-in/email-otp",
          "/sign-in/social",
          "/callback/:id",
          "/get-session",
          "/sign-out",
        ].includes(ctx.path)) {
          throw new APIError("NOT_FOUND", { message: "Not found." });
        }
        if (ctx.path === "/callback/:id" && ctx.params?.id !== "microsoft") {
          throw new APIError("NOT_FOUND", { message: "Not found." });
        }

        for (const field of ["email", "newEmail"]) {
          const email = ctx.body?.[field];
          if (typeof email === "string" && !isIllinoisEmail(email)) {
            throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isIllinoisEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
            }
          }
        },
        update: {
          before: async (user) => {
            if (user.email && !isIllinoisEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Use your Illinois NetID email." });
            }
          }
        },
      },
    },
    plugins: [
      magicLink({
        disableSignUp: false,
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url, token }, ctx) => {
          if (!ctx) throw new APIError("INTERNAL_SERVER_ERROR");
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(`sign-in-otp-${email.toLowerCase()}`);
          const otp = await otpPlugin.endpoints.createVerificationOTP({
            body: { email, type: "sign-in" },
            context: ctx.context,
          });
          // Email scanners can open links. Redeem the token only after a button click.
          const confirmationURL = new URL("/login/verify", url);
          confirmationURL.searchParams.set("token", token);
          await sendEmail(email, "Sign in to Router", `Click this link to sign in:\n\n${confirmationURL}\n\nOr enter this code on the sign-in page: ${otp}\n\nBoth expire in 5 minutes. If you didn't request this email, ignore it.`);
        },
      }),
      otpPlugin,
    ],
  });
}
