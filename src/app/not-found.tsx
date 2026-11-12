import Link from "next/link";
export default function NotFound() {
  return (
    <main className="px-6 py-[15vh] text-center">
      <h1 className="text-2xl font-semibold text-ink">页面不存在</h1>
      <p className="mt-2 text-muted-foreground">这个地址可能已变更。</p>
      <Link className="mt-5 inline-flex text-primary hover:underline" href="/overview">
        返回资源总览
      </Link>
    </main>
  );
}
