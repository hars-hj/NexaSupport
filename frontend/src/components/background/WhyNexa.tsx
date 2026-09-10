import type { JSX, ReactNode } from 'react'
import useScrollReveal from '../../hooks/useScrollReveal'

interface Feature {
  icon: ReactNode
  title: string
  desc: string
}

const features: Feature[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
    title: 'Your docs, your bot',
    desc: 'Upload PDFs and let Nexa chunk, embed, and index them. Every answer is grounded in your own knowledge base.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    ),
    title: 'Embeddable anywhere',
    desc: 'One script tag gives your site a branded chat widget. Customize the name, colors, avatar, and welcome message.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <line x1="11" y1="8" x2="11" y2="14" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
    title: 'Smart retrieval',
    desc: 'Hybrid vector + keyword search with reranking ensures the most relevant context is used for every answer.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    title: 'Live human handoff',
    desc: "When the bot isn't confident, visitors escalate to a real agent — with full chat history and context preserved.",
  },
]

export default function WhyNexa(): JSX.Element {
  const ref = useScrollReveal<HTMLElement>()

  return (
    <section id="why" ref={ref} className="py-16 sm:py-20 lg:py-25 px-5 sm:px-8 lg:px-15 scroll-mt-[68px]">
      <div className="max-w-[1100px] mx-auto">
        {/* Tag */}
        <div className="fu text-[10.5px] font-semibold tracking-[2.2px] uppercase text-teal mb-5 before:content-['/'] before:opacity-50">
          01 — Features
        </div>

        {/* Heading */}
        <h2
          className="fu delay-100 font-serif font-bold leading-[1.12] tracking-[-0.5px] mb-4 max-w-[640px] text-white"
          style={{ fontSize: 'clamp(32px, 4.2vw, 52px)' }}
        >
          Everything you need to<br />
          automate your support.
        </h2>

        {/* Sub */}
        <p className="fu delay-200 text-[15px] text-white/62 leading-[1.8] max-w-[520px] mb-13">
          From document ingestion to live agent handoff — Nexa handles the full
          loop so your team can focus on the conversations that matter.
        </p>

        {/* Grid — 2x2 for 4 cards */}
        <div className="fu delay-300 grid grid-cols-1 sm:grid-cols-2 border border-white/9 rounded-2xl overflow-hidden bg-[#1a3543] backdrop-blur-2xl">
          {features.map((f, i) => {
            const isRightCol = (i + 1) % 2 === 0
            const isBottomRow = i >= 2
            return (
              <div
                key={f.title}
                className={[
                  'p-6 sm:p-8 transition-colors hover:bg-teal/4',
                  isBottomRow ? '' : 'border-b border-white/7',
                  isRightCol ? '' : 'sm:border-r border-white/7',
                  // mobile: always border-b except last
                  i < features.length - 1 ? 'border-b sm:border-b-0' : '',
                  isBottomRow ? '' : 'sm:border-b',
                ].join(' ')}
              >
                <span className="text-teal block mb-4">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    {f.icon}
                  </svg>
                </span>
                <div className="font-serif text-[17px] font-bold mb-2.5 text-white leading-snug">
                  {f.title}
                </div>
                <p className="text-[13px] text-white/58 leading-[1.72]">{f.desc}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}