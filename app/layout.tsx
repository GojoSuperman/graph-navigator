import type { Metadata } from "next";
import { Suspense } from "react";
import VizDock from "./VizDock.tsx";
import Settings from "./Settings.tsx";
import DomainNav from "./DomainNav.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "그래프 네비게이터",
  description: "하나의 GraphRAG 엔진에 영화·인물 두 도메인. 근거와 탄 경로를 함께 보여 줍니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {/*
          **상단 도메인 탭.** 같은 엔진에 두 도메인이 붙어 있다는 것이 이 앱의 구조이고,
          그것이 한눈에 보여야 한다. 영화 경로(/·/browse·/map)는 그대로 둔다.
        */}
        <nav className="nav">
          <span className="brand">그래프 네비게이터</span>
          <DomainNav />
          <Settings />
          {/* TMDB 이용 약관이 요구하는 고지 */}
          <span className="src">데이터 · TMDB (인증·보증 관계 없음) · 위키백과</span>
        </nav>
        {/*
          화면을 세로로 나눈다. 왼쪽은 각자 독립된 페이지, 오른쪽은 **붙박이 3D**.
          3D 를 별도 페이지로 두었더니 보러 가면 원래 보던 것을 떠나야 했다.
        */}
        <div className="shell">
          <div className="shell-main">{children}</div>
          <Suspense fallback={null}>
            <VizDock />
          </Suspense>
        </div>
      </body>
    </html>
  );
}
