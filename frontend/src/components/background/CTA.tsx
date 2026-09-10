import type { JSX } from 'react/jsx-runtime'
import useScrollReveal from '../../hooks/useScrollReveal'
import { useNavigate } from 'react-router-dom'

export default function CTA(): JSX.Element {
  const ref = useScrollReveal<HTMLElement>()
  const navigate = useNavigate()

  return (
    <section ref={ref} className="pt-16 sm:pt-20 lg:pt-25 px-5 sm:px-8 lg:px-15 pb-0">
      <div className="max-w-[1100px] mx-auto">
        <div className="fu bg-[#1a3543] border border-white/9 rounded-[18px] px-6 sm:px-10 lg:px-13 py-10 sm:py-12 lg:py-15 backdrop-blur-2xl text-center sm:text-left">
          <h2
            className="font-serif font-bold leading-[1.08] tracking-[-0.4px] mb-3.5 text-white"
            style={{ fontSize: 'clamp(28px, 4vw, 54px)' }}
          >
            Ready to try{' '}
            <em className="italic text-teal">Nexa</em>?
          </h2>
          <p className="text-[15px] text-white/62 max-w-[480px] leading-[1.8] mb-8">
            Sign up to create your organization and deploy your first AI support
            widget in minutes.
          </p>
          <div className="flex flex-wrap gap-3 justify-center sm:justify-start">
            <button
              onClick={() => navigate('/signup')}
              className="bg-white text-[#0f2830] border-none px-6.5 py-3 rounded-full text-[14.5px] font-semibold cursor-pointer inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
            >
              Get started ↗
            </button>
            <button
              onClick={() => navigate('/login')}
              className="bg-[#06121a]/35 border border-white/26 text-white px-6.5 py-3 rounded-full text-[14.5px] cursor-pointer backdrop-blur-sm transition-all hover:bg-[#06121a]/55"
            >
              Sign in
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}