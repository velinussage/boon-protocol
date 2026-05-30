import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/global.css";

import { config } from "./lib/wagmi";
import { LandingPage } from "./pages/LandingPage";
import { SendPage } from "./pages/SendPage";
import { ClaimPage } from "./pages/ClaimPage";
import { CliPage } from "./pages/CliPage";
import { CliDonePage } from "./pages/CliDonePage";
import { FeedPage } from "./pages/FeedPage";
import { BoardPage } from "./pages/BoardPage";
import { BurnPage } from "./pages/BurnPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ReceiptPage } from "./pages/ReceiptPage";
import { SenderPage } from "./pages/SenderPage";
import { AttestationPage } from "./pages/AttestationPage";
import { PrivateTipIntentPage } from "./pages/PrivateTipIntentPage";
import { AuctionPage } from "./pages/AuctionPage";

// One QueryClient instance for the lifetime of the SPA — recreating it on
// every render would tear down wagmi's in-flight queries (account, balance,
// etc.) and re-trigger wallet provider requests.
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/claim" element={<ClaimPage />} />
            <Route path="/cli" element={<CliPage />} />
            <Route path="/cli/done" element={<CliDonePage />} />
            <Route path="/feed" element={<FeedPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/burn" element={<BurnPage />} />
            <Route path="/p/:handle" element={<ProfilePage />} />
            <Route path="/s/:address" element={<SenderPage />} />
            <Route path="/b/:txHash" element={<ReceiptPage />} />
            <Route path="/attestations/:tipId" element={<AttestationPage />} />
            <Route path="/private-tips/intent/:intentId" element={<PrivateTipIntentPage />} />
            <Route path="/auction" element={<AuctionPage />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
