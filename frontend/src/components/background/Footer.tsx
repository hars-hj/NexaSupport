import type { JSX } from "react/jsx-runtime"

export default function Footer(): JSX.Element {
  return (
    <footer className="px-5 sm:px-8 lg:px-15 pb-8">
      <div className="max-w-[1100px] mx-auto border-t border-white/9 pt-6 flex items-center justify-center">
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <div className="w-6 h-6 bg-white/14 rounded-md flex items-center justify-center text-[12px] font-bold text-white">
            N
          </div>
          <span className="text-[14px] font-semibold text-white">Nexa</span>
          <span className="text-[11px] text-white/30 tracking-wide sm:ml-3.5">
            © 2026 — Built for support teams who care
          </span>
        </div>
      </div>
    </footer>
  )
}