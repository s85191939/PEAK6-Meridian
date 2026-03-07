import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1"
);

export const RPC_URL = "https://api.devnet.solana.com";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

export const USDC_DECIMALS = 6;
export const PRICE_DECIMALS = 6;

export interface TickerInfo {
  ticker: string;
  name: string;
  logo: string;
  color: string;
}

export const MAG7_TICKERS: Record<string, TickerInfo> = {
  AAPL: {
    ticker: "AAPL",
    name: "Apple Inc.",
    logo: "/logos/aapl.svg",
    color: "#A2AAAD",
  },
  MSFT: {
    ticker: "MSFT",
    name: "Microsoft Corp.",
    logo: "/logos/msft.svg",
    color: "#00A4EF",
  },
  GOOGL: {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    logo: "/logos/googl.svg",
    color: "#4285F4",
  },
  AMZN: {
    ticker: "AMZN",
    name: "Amazon.com Inc.",
    logo: "/logos/amzn.svg",
    color: "#FF9900",
  },
  NVDA: {
    ticker: "NVDA",
    name: "NVIDIA Corp.",
    logo: "/logos/nvda.svg",
    color: "#76B900",
  },
  META: {
    ticker: "META",
    name: "Meta Platforms Inc.",
    logo: "/logos/meta.svg",
    color: "#0668E1",
  },
  TSLA: {
    ticker: "TSLA",
    name: "Tesla Inc.",
    logo: "/logos/tsla.svg",
    color: "#CC0000",
  },
};

export const TICKER_LIST = Object.values(MAG7_TICKERS);
