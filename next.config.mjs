/** @type {import('next').NextConfig} */
const nextConfig = {
  // data/graph.json 은 런타임에 fs 로 읽는다 (큰 JSON 을 타입 추론에 태우지 않기 위해).
  outputFileTracingIncludes: {
    "/api/ask": ["./data/graph.json"],
    "/api/focus": ["./data/graph.json"],
    "/api/graph": ["./data/graph.json"],
    "/browse": ["./data/graph.json"],
    "/map": ["./data/graph.json"],
  },
};
export default nextConfig;
