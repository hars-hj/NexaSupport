import type { JSX } from "react/jsx-runtime"
import useScrollReveal from "../../hooks/useScrollReveal"

interface Step {
  label: string
  title: string
  desc: string
}

const steps: Step[] = [
  {
    label: 'Step 01',
    title: 'Connect',
    desc: 'Point Nexa at your help center, ticket archive, or Notion. We handle parsing, chunking, and embedding.',
  },
  {
    label: 'Step 02',
    title: 'Tune',
    desc: "Pick a voice, set escalation rules, define what's off-limits. Test inside our playground before shipping.",
  },
  {
    label: 'Step 03',
    title: 'Embed',
    desc: 'Drop in a single line of JS to embed the chat widget anywhere on your site.',
  },
]

const delays = ['delay-200', 'delay-300', 'delay-400'] as const

export default function Deploy(): JSX.Element {
  const ref = useScrollReveal<HTMLElement>()

  return (
    <section id="deploy" ref={ref} className="py-16 sm:py-20 lg:py-25 px-5 sm:px-8 lg:px-15 scroll-mt-[68px]">
      <div className="max-w-[1100px] mx-auto">
        {/* Tag */}
        <div className="fu text-[10.5px] font-semibold tracking-[2.2px] uppercase text-teal mb-5 before:content-['/'] before:opacity-50">
          03 — Deploy
        </div>

        {/* Heading */}
        <h2
          className="fu delay-100 font-serif font-bold leading-[1.08] tracking-[-0.5px] mb-13 text-white"
          style={{ fontSize: 'clamp(30px, 4.5vw, 56px)' }}
        >
          From zero to answering<br />
          tickets in an afternoon.
        </h2>

        {/* Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {steps.map((s, i) => (
            <div
              key={s.label}
              className={`fu ${delays[i]} bg-[#1a3543] border border-white/9 rounded-2xl p-7.5 backdrop-blur-2xl transition-colors hover:border-teal/30`}
            >
              <div className="text-[10px] font-bold tracking-[2px] text-teal uppercase mb-3.5">
                {s.label}
              </div>
              <div className="font-serif text-[26px] font-bold text-white mb-3 leading-snug">
                {s.title}
              </div>
              <p className="text-[13.5px] text-white/60 leading-[1.75]">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}