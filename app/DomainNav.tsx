"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 도메인 탭과 그에 딸린 메뉴.
 *
 * **지금 어느 도메인에 있느냐에 따라 아래 메뉴가 통째로 바뀐다.** 인물 탭에서
 * "작품 탐색기" 가 보이면 같은 앱의 다른 도메인이 아니라 **섞인 앱**으로 보인다.
 */
const MENUS = {
  movie: [
    { href: "/", label: "질문" },
    { href: "/browse", label: "작품 탐색기" },
    { href: "/map", label: "지도" },
  ],
  history: [
    { href: "/history", label: "질문" },
    { href: "/history/browse", label: "인물 탐색기" },
    { href: "/history/map", label: "지도" },
  ],
} as const;

export default function DomainNav() {
  const path = usePathname() ?? "/";
  const domain: keyof typeof MENUS = path.startsWith("/history") ? "history" : "movie";
  const on = (href: string) =>
    href === "/" || href === "/history" ? path === href : path.startsWith(href);

  return (
    <>
      <Link href="/" className={`domain${domain === "movie" ? " on" : ""}`}>🎬 영화</Link>
      <Link href="/history" className={`domain${domain === "history" ? " on" : ""}`}>🏛 인물</Link>
      <span className="nav-sep" />
      {MENUS[domain].map((m) => (
        <Link key={m.href} href={m.href} className={on(m.href) ? "here" : ""}>{m.label}</Link>
      ))}
    </>
  );
}
