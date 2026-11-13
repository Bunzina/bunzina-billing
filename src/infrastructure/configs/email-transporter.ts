import nodemailer from 'nodemailer';

const port = Number(process.env.EMAIL_SMTP_PORT || 587);

export const emailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port,
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASSWORD,
  },
  secure: port === 465,
});

export const DEFAULT_EMAIL = process.env.EMAIL ?? 'bunzina@local.com';
