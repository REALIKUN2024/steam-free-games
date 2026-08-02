import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Steam 喜加一 · 免费游戏总览",
  description:
    "实时汇总 Steam 当前所有可免费入库存玩的游戏，支持搜索、筛选、排序与收藏，助你不错过任何一款免费好游。",
  keywords: ["Steam", "喜加一", "免费游戏", "免费游玩", "Free to Play"],
  icons: { icon: "/favicon.ico" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
