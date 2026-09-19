import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import VizDock from "./VizDock.tsx";
import Settings from "./Settings.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "영화 네비게이터",
  description: "한국 영화와 그 인물이 참여한 외국 영화를 그래프로 이어 근거와 함께 답합니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <nav className="nav">
          <span className="brand">🎬 영화 네비게이터</span>
          <Link href="/">질문</Link>
          <Link href="/browse">작품 탐색기</Link>
          <Link href="/map">지도</Link>
          <Settings />
          {/* TMDB 이용 약관이 요구하는 고지 */}
          <span className="src">데이터 · TMDB (인증·보증 관계 없음)</span>
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
