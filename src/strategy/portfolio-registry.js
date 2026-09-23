import { QuantPortfolio } from "./quant-portfolio.js";

export class PortfolioRegistry {
  constructor(portfolioFactory = (pair) => new QuantPortfolio()) {
    this.factory = typeof portfolioFactory === "function"
      ? portfolioFactory
      : (pair) => new QuantPortfolio(portfolioFactory);
    this.portfolios = new Map();
  }

  get(pair) {
    const key = String(pair || "").trim().toUpperCase();
    if (!this.portfolios.has(key)) {
      this.portfolios.set(key, this.factory(key));
    }
    return this.portfolios.get(key);
  }

  setPayout(pair, payout) {
    this.get(pair).setPayout(payout);
  }

  setGlobalPayout(payout) {
    for (const portfolio of this.portfolios.values()) {
      portfolio.setPayout(payout);
    }
  }

  clear() {
    this.portfolios.clear();
  }

  delete(pair) {
    return this.portfolios.delete(String(pair || "").trim().toUpperCase());
  }
}
