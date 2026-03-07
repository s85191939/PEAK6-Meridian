import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import Navbar from "@/components/Navbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Meridian - Binary Stock Outcome Markets",
  description:
    "Trade binary outcome markets on MAG7 stocks. Built on Solana.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased`}>
        <WalletProvider>
          <div className="flex min-h-screen flex-col bg-gray-950 text-gray-100">
            <Navbar />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-gray-800 py-6">
              <div className="mx-auto max-w-7xl px-4 sm:px-6">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-600">
                    Meridian Protocol &middot; Solana Devnet
                  </p>
                  <div className="flex items-center gap-4 text-xs text-gray-600">
                    <span>Binary Outcome Markets</span>
                    <span>&middot;</span>
                    <span>MAG7 Stocks</span>
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
