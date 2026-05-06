import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "絆データワークス",
  description: "絆データワークス",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DotGothic16&family=Zen+Kurenaido&family=Noto+Sans+JP:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ fontFamily: "'Noto Sans JP', sans-serif", margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
