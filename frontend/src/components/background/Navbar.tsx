import type { JSX } from "react/jsx-runtime"
import { useState } from "react"
import { useNavigate } from "react-router-dom";

interface NavbarProps {
  onStartFree?: () => void
}

const NAV_LINKS: { href: string; label: string }[] = [
  { href: "#why", label: "Features" },
  { href: "#how", label: "How it works" },
]

export default function Navbar({ onStartFree }: NavbarProps): JSX.Element {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLoginClick = () => {
    setMenuOpen(false);
    navigate("/login");
  };

  const handleStartFree = () => {
    setMenuOpen(false);
    onStartFree?.();
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0f2830]/90 backdrop-blur-sm md:bg-transparent md:backdrop-blur-none">
      <div className="h-[68px] flex items-center px-4 sm:px-6 lg:px-15 gap-4 lg:gap-9">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2.5 no-underline text-white font-semibold text-[15px] tracking-tight shrink-0">
          <div className="w-[30px] h-[30px] bg-teal-dark rounded-lg flex items-center justify-center shrink-0">
            <svg
              className="w-[15px] h-[15px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          </div>
          Nexa
        </a>

        <ul className="hidden lg:flex gap-8 ml-auto list-none">
          {NAV_LINKS.map(({ href, label }) => (
            <li key={label}>
              <a
                href={href}
                className="text-white/75 no-underline text-[13.5px] font-normal transition-colors hover:text-white"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden md:flex items-center gap-2.5 ml-auto lg:ml-6">
          <button
            onClick={handleLoginClick}
            className="bg-transparent border border-white/30 text-white px-5 py-2 rounded-full text-[13px] font-medium cursor-pointer transition-all hover:bg-white/10 hover:border-white/50 whitespace-nowrap"
          >
            Sign in
          </button>
          <button
            onClick={handleStartFree}
            className="bg-white text-[#0f2830] border-none px-5 py-2 rounded-full text-[13px] font-semibold cursor-pointer transition-opacity hover:opacity-90 whitespace-nowrap"
          >
            Get Started ↗
          </button>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="md:hidden ml-auto flex flex-col justify-center items-center gap-[5px] w-9 h-9 shrink-0 bg-transparent border-none cursor-pointer"
        >
          <span
            className={`block h-[2px] w-6 bg-white transition-transform duration-200 ${
              menuOpen ? "translate-y-[7px] rotate-45" : ""
            }`}
          />
          <span
            className={`block h-[2px] w-6 bg-white transition-opacity duration-200 ${
              menuOpen ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`block h-[2px] w-6 bg-white transition-transform duration-200 ${
              menuOpen ? "-translate-y-[7px] -rotate-45" : ""
            }`}
          />
        </button>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <div className="md:hidden bg-[#0f2830] border-t border-white/10 px-4 sm:px-6 py-4 flex flex-col gap-4">
          <ul className="flex flex-col gap-3 list-none">
            {NAV_LINKS.map(({ href, label }) => (
              <li key={label}>
                <a
                  href={href}
                  onClick={() => setMenuOpen(false)}
                  className="text-white/75 no-underline text-[15px] font-normal transition-colors hover:text-white block py-1"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2.5 pt-2 border-t border-white/10">
            <button
              onClick={handleLoginClick}
              className="bg-transparent border border-white/30 text-white px-5 py-2.5 rounded-full text-[13px] font-medium cursor-pointer transition-all hover:bg-white/10 hover:border-white/50 w-full"
            >
              Sign in
            </button>
            <button
              onClick={handleStartFree}
              className="bg-white text-[#0f2830] border-none px-5 py-2.5 rounded-full text-[13px] font-semibold cursor-pointer transition-opacity hover:opacity-90 w-full"
            >
              Get Started ↗
            </button>
          </div>
        </div>
      )}
    </nav>
  )
}