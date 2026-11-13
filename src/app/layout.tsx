import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grammar Loop · 英语语法诊断",
  description: "从错题诊断到针对性练习，让语法学习有迹可循。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
