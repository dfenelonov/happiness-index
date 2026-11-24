import { NextResponse } from "next/server";

/**
 * 303 на путь своего сайта с относительным Location: браузер остаётся на том адресе, с которого пришёл.
 * req.nextUrl.origin за прокси и под `next start -H` бывает localhost — для редиректов он не годится.
 */
export const seeOther = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path } });
