import { useNavigate } from 'react-router-dom'
import VideoBackground from './VideoBackground'
import Navbar from './Navbar'
import Hero from './Hero'
import WhyNexa from './WhyNexa'
import HowItWorks from './RAG'
import CTA from './CTA'
import Footer from './Footer'

export default function LandingPage() {
  const navigate = useNavigate()

  return (
    <>
      <VideoBackground />
      <div className="relative z-10">
        <Navbar onStartFree={() => navigate('/signup')} />
        <Hero onStartFree={() => navigate('/signup')} />
        <WhyNexa />
        <HowItWorks />
        <CTA />
        <Footer />
      </div>
    </>
  )
}