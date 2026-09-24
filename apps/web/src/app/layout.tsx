import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Profile Photo Scorer',
  description:
    'Scores a professional profile photo 1-10 with a per-axis breakdown and specific fixes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
