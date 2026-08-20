// M51 — Receipt PDF generator. Streams a single-page PDF straight from the
// /api/jobs/:id/receipt endpoint so the customer can save it to their
// reimbursement portal or email it on.
//
// Layout: header (ServiceLink + receipt number) → meta block (job id, date,
// service, partner name + GSTIN if any) → itemised lines (service /
// materials / travel / platform fee / GST / tip) → grand total → payment
// method + razorpay_payment_id (or "Cash" + partner confirmation note) →
// quiet footer with the platform contact.

const PDFDocument = require('pdfkit')
const Job         = require('../models/Job')
const { db }      = require('../config/db')
const { billBreakdown } = require('./paymentController')

const fmt = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN')}`
const dateStr = (d) => new Date(d || Date.now()).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})

module.exports = {
  // GET /api/jobs/:id/receipt — streams a PDF.
  // Authorized for either party on the job. Only works once the job is
  // paid (otherwise there's no payment to receipt).
  getReceipt: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (uid !== job.customer_id && uid !== job.partner_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (job.state !== 'paid') {
        return res.status(409).json({ success: false, message: 'Receipt available after payment' })
      }

      const payment = await db('payments')
        .where({ job_id: job.id, status: 'completed' })
        .orderBy('paid_at', 'desc').first()

      const breakdown = await billBreakdown(job, { tip: payment?.tip || 0 })

      // Send the PDF inline so the browser tab opens it; the client
      // download button can also add `?dl=1` to force attachment.
      const filename = `receipt-${String(job.id).slice(-6)}.pdf`
      const disposition = req.query?.dl === '1' ? 'attachment' : 'inline'
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`)

      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      doc.pipe(res)

      // ── Header ─────────────────────────────────────────
      doc.fontSize(20).fillColor('#0a0f1e').text('ServiceLink', { align: 'left' })
      doc.fontSize(10).fillColor('#666')
         .text('Payment Receipt', { align: 'left' })
      doc.moveDown(0.5)
      doc.fontSize(9).fillColor('#888')
         .text(`Receipt # ${String(job.id).toUpperCase()}`)
         .text(`Issued: ${dateStr(job.paid_at)}`)

      doc.moveDown(1.5)
      doc.strokeColor('#e4e1db').lineWidth(1)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.moveDown(1)

      // ── Job meta ───────────────────────────────────────
      doc.fontSize(10).fillColor('#0a0f1e').font('Helvetica-Bold')
         .text('Service rendered')
      doc.font('Helvetica').fillColor('#222')
         .text(`${job.service || job.category_name || '—'} by ${job.partner_name || 'Partner'}`)
      doc.moveDown(0.5)
      doc.font('Helvetica-Bold').text('Customer')
      doc.font('Helvetica').text(`${job.customer_name || '—'}`)
      if (job.customer_address) doc.text(job.customer_address)
      doc.moveDown(0.5)
      doc.font('Helvetica-Bold').text('Partner')
      doc.font('Helvetica').text(`${job.partner_name || '—'}`)
      // GSTIN placeholder — when partner profile carries a real GSTIN, swap it in.
      doc.fillColor('#888').fontSize(9)
         .text('GSTIN: —  (add to partner profile)')

      doc.moveDown(1.2)
      doc.strokeColor('#e4e1db').lineWidth(1)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.moveDown(0.8)

      // ── Itemised lines ─────────────────────────────────
      doc.fontSize(10).fillColor('#0a0f1e').font('Helvetica-Bold').text('Bill breakdown')
      doc.font('Helvetica').fontSize(10).fillColor('#222')
      const lineRow = (label, value) => {
        const y = doc.y
        doc.text(label, 50, y, { width: 350 })
        doc.text(value, 50, y, { width: 495, align: 'right' })
        doc.moveDown(0.4)
      }
      if (breakdown.service   > 0) lineRow('Service / labour',    fmt(breakdown.service))
      if (breakdown.materials > 0) lineRow('Materials',           fmt(breakdown.materials))
      if (breakdown.travel    > 0) lineRow('Travel',              fmt(breakdown.travel))
      lineRow(
        `Platform fee${breakdown.platformFeePct ? ` (${breakdown.platformFeePct}%)` : ''}`,
        breakdown.platformFee > 0 ? fmt(breakdown.platformFee) : 'Free',
      )
      lineRow(
        `GST (${breakdown.gstPct}%)`,
        breakdown.gst > 0 ? fmt(breakdown.gst) : '—',
      )
      if (breakdown.tip > 0) lineRow('Tip', fmt(breakdown.tip))

      doc.moveDown(0.4)
      doc.strokeColor('#0a0f1e').lineWidth(1)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.moveDown(0.4)

      // ── Total ──────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#0a0f1e')
      const totalY = doc.y
      doc.text('Total paid', 50, totalY, { width: 350 })
      doc.text(fmt(breakdown.total), 50, totalY, { width: 495, align: 'right' })
      doc.moveDown(1.2)

      // ── Payment details ────────────────────────────────
      doc.fontSize(10).font('Helvetica-Bold').text('Payment')
      doc.font('Helvetica').fillColor('#222')
      const method = (payment?.method || 'upi').toUpperCase()
      doc.text(`Method: ${method}`)
      if (payment?.razorpay_payment_id) {
        doc.text(`Razorpay ID: ${payment.razorpay_payment_id}`)
      }
      if (payment?.paid_at) {
        doc.text(`Paid at: ${dateStr(payment.paid_at)}`)
      }

      doc.moveDown(2)
      doc.fontSize(8).fillColor('#888').font('Helvetica-Oblique')
         .text('Generated by ServiceLink. Keep this receipt for your records.',
               { align: 'center' })

      doc.end()
    } catch (err) { next(err) }
  },
}
