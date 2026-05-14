import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PassVault',
  description: 'Безопасный менеджер паролей',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" data-theme="dark">
      <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>{children}</body>
    </html>
  );
}
