import type { JSX } from 'react/jsx-runtime'
import useScrollReveal from '../../hooks/useScrollReveal'
import { useNavigate } from 'react-router-dom'

interface HeroProps {
  onStartFree?: () => void
}

export default function Hero({ onStartFree }: HeroProps): JSX.Element {
  const ref = useScrollReveal<HTMLElement>()
  const navigate = useNavigate()

  return (
    <section
      ref={ref}
      className="min-h-screen flex flex-col justify-center px-5 sm:px-8 lg:px-15 pt-[100px] pb-20"
    >
      <div className="max-w-[720px] w-full">
        {/* Headline */}
        <h1
          className="fu delay-100 font-serif font-bold leading-[1.08] tracking-[-1.5px] mb-6 text-white"
          style={{ fontSize: 'clamp(44px, 6vw, 78px)' }}
        >
          Turn your docs into<br />
          an <em className="text-teal not-italic italic">AI support agent</em>
        </h1>

        {/* Subtext */}
        <p className="fu delay-200 text-[16px] text-white/65 leading-[1.8] max-w-[500px] mb-10 font-normal">
          Upload your knowledge base, get an embeddable chat widget that answers
          from your own content — and hands off to a human agent when it can't.
        </p>

        {/* Single CTA */}
        <div className="fu delay-300 flex flex-wrap gap-3">
          <button
            onClick={() => onStartFree ? onStartFree() : navigate('/signup')}
            className="bg-teal text-[#0a2028] border-none px-7 py-3.5 rounded-full text-[15px] font-semibold cursor-pointer transition-all hover:bg-teal-dark hover:-translate-y-px"
          >
            Get Started ↗
          </button>
          <a
            href="#how"
            className="no-underline bg-[#08161e]/40 border border-white/20 text-white px-7 py-3.5 rounded-full text-[15px] font-normal cursor-pointer backdrop-blur-sm transition-all hover:bg-[#08161e]/60 inline-flex items-center"
          >
            How it works
          </a>
        </div>
      </div>
    </section>
  )
}