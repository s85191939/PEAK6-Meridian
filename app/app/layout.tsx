import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import Navbar from "@/components/Navbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "PEAK6 Meridian — Binary Outcome Markets on Solana",
  description:
    "Trade Yes/No contracts on MAG7 stocks. Predict daily closing prices. Built on Solana devnet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrains.variable} font-sans antialiased`}>
        <WalletProvider>
          <div className="flex min-h-screen flex-col bg-[#0a0a0a] text-gray-100">
            <Navbar />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-gray-800/40 py-6">
              <div className="mx-auto max-w-7xl px-4 sm:px-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-yellow-500/70">PEAK6</span>
                    <p className="text-xs text-gray-600">
                      Meridian Protocol &middot; Solana Devnet &middot; Not financial advice
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-700">
                    <span>$1.00 invariant</span>
                    <span>&middot;</span>
                    <span>MAG7 Stocks</span>
                    <span>&middot;</span>
                    <span>0DTE Contracts</span>
                  </div>
                </div>
              </div>
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
