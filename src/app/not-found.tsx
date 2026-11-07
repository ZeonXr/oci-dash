import Link from "next/link";
export default function NotFound() { return <main style={{ padding: "15vh 24px", textAlign: "center" }}><h1>页面不存在</h1><p>这个地址可能已变更。</p><Link href="/overview">返回资源总览</Link></main>; }
