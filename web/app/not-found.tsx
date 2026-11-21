import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-24 text-center">
      <p className="font-serif text-6xl text-accent">404</p>
      <h1 className="mt-4 font-serif text-3xl font-semibold">Такой страницы нет</h1>
      <p className="mt-3 text-muted">Возможно, ссылка устарела. Зато тест на месте.</p>
      <Link href="/" className="btn-primary mt-8">На главную</Link>
    </div>
  );
}
