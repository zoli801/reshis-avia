import type { Metadata } from "next";
import "./globals.css";
import "./avia/voxel.css";
import "./avia/pixel-font.css";
import "./avia/plains-backdrop.css";

export const metadata: Metadata = {
  title: "Решись Авиа — спрос и цены",
  description: "Прогноз спроса, сравнение цен авиабилетов и сохранение обоснованных решений.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head><script src="/vendor/telegram-web-app.js" /></head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
